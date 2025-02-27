/*
 * Unless explicitly stated otherwise all files in this repository are licensed
 * under the Apache License Version 2.0.
 *
 * This product includes software developed at Datadog (https://www.datadoghq.com/).
 * Copyright 2021 Datadog, Inc.
 */

import * as Serverless from "serverless";
import * as layers from "./layers.json";
import * as govLayers from "./layers-gov.json";
import { version } from "../package.json";

import { getConfig, setEnvConfiguration, forceExcludeDepsFromWebpack, hasWebpackPlugin, Configuration } from "./env";
import { applyExtensionLayer, applyLambdaLibraryLayers, findHandlers, FunctionInfo, RuntimeType } from "./layer";
import { TracingMode, enableTracing } from "./tracing";
import { redirectHandlers } from "./wrapper";
import { addCloudWatchForwarderSubscriptions } from "./forwarder";
import { addOutputLinks, printOutputs } from "./output";
import { FunctionDefinition } from "serverless";

// Separate interface since DefinitelyTyped currently doesn't include tags or env
export interface ExtendedFunctionDefinition extends FunctionDefinition {
  tags?: { [key: string]: string };
  environment?: { [key: string]: string };
}

enum TagKeys {
  Service = "service",
  Env = "env",
  Plugin = "dd_sls_plugin",
}

module.exports = class ServerlessPlugin {
  public hooks = {
    "after:datadog:clean:init": this.afterPackageFunction.bind(this),
    "after:datadog:generate:init": this.beforePackageFunction.bind(this),
    "after:deploy:function:packageFunction": this.afterPackageFunction.bind(this),
    "after:package:createDeploymentArtifacts": this.afterPackageFunction.bind(this),
    "after:package:initialize": this.beforePackageFunction.bind(this),
    "before:deploy:function:packageFunction": this.beforePackageFunction.bind(this),
    "before:offline:start:init": this.beforePackageFunction.bind(this),
    "before:step-functions-offline:start": this.beforePackageFunction.bind(this),
    "after:deploy:deploy": this.afterDeploy.bind(this),
  };

  public commands = {
    datadog: {
      commands: {
        clean: {
          lifecycleEvents: ["init"],
          usage: "Cleans up wrapper handler functions for DataDog, not necessary in most cases",
        },
        generate: {
          lifecycleEvents: ["init"],
          usage: "Generates wrapper handler functions for DataDog, not necessary in most cases",
        },
      },
      lifecycleEvents: ["clean", "generate"],
      usage: "Automatically instruments your lambdas with DataDog",
    },
  };
  constructor(private serverless: Serverless, _: Serverless.Options) {}

  private async beforePackageFunction() {
    const config = getConfig(this.serverless.service);
    if (config.enabled === false) return;
    this.serverless.cli.log("Auto instrumenting functions with Datadog");
    validateConfiguration(config);
    setEnvConfiguration(config, this.serverless.service);

    const defaultRuntime = this.serverless.service.provider.runtime;
    const handlers = findHandlers(this.serverless.service, config.exclude, defaultRuntime);
    const allLayers = { regions: { ...layers.regions, ...govLayers.regions } };
    if (config.addLayers) {
      this.serverless.cli.log("Adding Lambda Library Layers to functions");
      this.debugLogHandlers(handlers);
      applyLambdaLibraryLayers(this.serverless.service.provider.region, handlers, allLayers);
      if (hasWebpackPlugin(this.serverless.service)) {
        forceExcludeDepsFromWebpack(this.serverless.service);
      }
    } else {
      this.serverless.cli.log("Skipping adding Lambda Library Layers, make sure you are packaging them yourself");
    }

    if (config.addExtension) {
      this.serverless.cli.log("Adding Datadog Lambda Extension Layer to functions");
      this.debugLogHandlers(handlers);
      applyExtensionLayer(this.serverless.service.provider.region, handlers, allLayers);
    } else {
      this.serverless.cli.log("Skipping adding Lambda Extension Layer");
    }

    let tracingMode = TracingMode.NONE;
    if (config.enableXrayTracing && config.enableDDTracing) {
      tracingMode = TracingMode.HYBRID;
    } else if (config.enableDDTracing) {
      tracingMode = TracingMode.DD_TRACE;
    } else if (config.enableXrayTracing) {
      tracingMode = TracingMode.XRAY;
    }
    enableTracing(this.serverless.service, tracingMode);
  }

  private async afterPackageFunction() {
    const config = getConfig(this.serverless.service);
    const forwarderArn: string | undefined = config.forwarderArn;
    const forwarder: string | undefined = config.forwarder;

    let datadogForwarderArn;
    if (config.enabled === false) return;
    if (config.addExtension === false) {
      if (forwarderArn && forwarder) {
        throw new Error(
          "Both 'forwarderArn' and 'forwarder' parameters are set. Please only use the 'forwarderArn' parameter.",
        );
      } else if (forwarderArn !== undefined && forwarder === undefined) {
        datadogForwarderArn = forwarderArn;
      } else if (forwarder !== undefined && forwarderArn === undefined) {
        datadogForwarderArn = forwarder;
      }

      if (datadogForwarderArn) {
        const aws = this.serverless.getProvider("aws");
        const errors = await addCloudWatchForwarderSubscriptions(this.serverless.service, aws, datadogForwarderArn);
        for (const error of errors) {
          this.serverless.cli.log(error);
        }
      }
    }
    this.addPluginTag();

    if (config.enableTags) {
      this.serverless.cli.log("Adding service and environment tags to functions");
      this.addServiceAndEnvTags();
    }

    const defaultRuntime = this.serverless.service.provider.runtime;
    const handlers = findHandlers(this.serverless.service, config.exclude, defaultRuntime);
    redirectHandlers(handlers, config.addLayers);

    addOutputLinks(this.serverless, config.site);
  }

  private async afterDeploy() {
    const config = getConfig(this.serverless.service);
    if (config.enabled === false) return;
    return printOutputs(this.serverless);
  }

  private debugLogHandlers(handlers: FunctionInfo[]) {
    for (const handler of handlers) {
      if (handler.type === RuntimeType.UNSUPPORTED) {
        if (handler.runtime === undefined) {
          this.serverless.cli.log(`Unable to determine runtime for function ${handler.name}`);
        } else {
          this.serverless.cli.log(
            `Unable to add Lambda Layers to function ${handler.name} with runtime ${handler.runtime}`,
          );
        }
      }
    }
  }

  /**
   * Check for service and env tags on provider level (under tags and stackTags),
   * as well as function level. Automatically create tags for service and env with
   * properties from deployment configurations if needed; does not override any existing values.
   */
  private addServiceAndEnvTags() {
    let providerServiceTagExists = false;
    let providerEnvTagExists = false;

    const provider = this.serverless.service.provider as any;

    const providerTags = provider.tags;
    if (providerTags !== undefined) {
      providerServiceTagExists = providerTags[TagKeys.Service] !== undefined;
      providerEnvTagExists = providerTags[TagKeys.Env] !== undefined;
    }

    const providerStackTags = provider.stackTags;
    if (providerStackTags !== undefined) {
      providerServiceTagExists = providerServiceTagExists || providerStackTags[TagKeys.Service] !== undefined;
      providerEnvTagExists = providerEnvTagExists || providerStackTags[TagKeys.Env] !== undefined;
    }

    if (!providerServiceTagExists || !providerEnvTagExists) {
      this.serverless.service.getAllFunctions().forEach((functionName) => {
        const functionDefintion: ExtendedFunctionDefinition = this.serverless.service.getFunction(functionName);
        if (!functionDefintion.tags) {
          functionDefintion.tags = {};
        }
        if (!providerServiceTagExists && !functionDefintion.tags[TagKeys.Service]) {
          functionDefintion.tags[TagKeys.Service] = this.serverless.service.getServiceName();
        }
        if (!providerEnvTagExists && !functionDefintion.tags[TagKeys.Env]) {
          functionDefintion.tags[TagKeys.Env] = this.serverless.getProvider("aws").getStage();
        }
      });
    }
  }

  /**
   * Tags the function(s) with plugin version
   */
  private async addPluginTag() {
    this.serverless.cli.log(`Adding Plugin Version ${version}`);

    this.serverless.service.getAllFunctions().forEach((functionName) => {
      const functionDefintion: ExtendedFunctionDefinition = this.serverless.service.getFunction(functionName);
      if (!functionDefintion.tags) {
        functionDefintion.tags = {};
      }

      functionDefintion.tags[TagKeys.Plugin] = `v${version}`;
    });
  }
};

function validateConfiguration(config: Configuration) {
  const siteList: string[] = ["datadoghq.com", "datadoghq.eu", "us3.datadoghq.com", "ddog-gov.com"];
  if (config.apiKey !== undefined && config.apiKMSKey !== undefined) {
    throw new Error("`apiKey` and `apiKMSKey` should not be set at the same time.");
  }

  if (config.site !== undefined && !siteList.includes(config.site.toLowerCase())) {
    throw new Error(
      "Warning: Invalid site URL. Must be either datadoghq.com, datadoghq.eu, us3.datadoghq.com, or ddog-gov.com.",
    );
  }
  if (config.addExtension) {
    if (config.forwarder || config.forwarderArn) {
      throw new Error("`addExtension` and `forwarder`/`forwarderArn` should not be set at the same time.");
    }
    if (config.apiKey === undefined && config.apiKMSKey === undefined) {
      throw new Error("When `addExtension` is true, `apiKey` or `apiKMSKey` must also be set.");
    }
  }
}
