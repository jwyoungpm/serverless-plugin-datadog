#!/bin/bash

# Unless explicitly stated otherwise all files in this repository are licensed
# under the Apache License Version 2.0.
# This product includes software developed at Datadog (https://www.datadoghq.com/).
# Copyright 2019 Datadog, Inc.

# Writes layer info to easily readable json file

# Call: ./scripts/generate_layers_json [-g]
# Opts:
#   -g: generate govcloud file

set -e

LAYER_NAMES=("Datadog-Node8-10" "Datadog-Node10-x" "Datadog-Node12-x" "Datadog-Node14-x" "Datadog-Python27" "Datadog-Python36" "Datadog-Python37" "Datadog-Python38" "Datadog-Extension")
JSON_LAYER_NAMES=("nodejs8.10" "nodejs10.x" "nodejs12.x" "nodejs14.x" "python2.7" "python3.6" "python3.7" "python3.8" "extension")
AVAILABLE_REGIONS=$(aws ec2 describe-regions | jq -r '.[] | .[] | .RegionName')

FILE_NAME="src/layers.json"

INPUT_JSON="{\"regions\":{}}"

if [ $1 = "-g" ]; then
    FILE_NAME="src/layers-gov.json"
fi

for region in $AVAILABLE_REGIONS
do
    for ((i=0;i<${#LAYER_NAMES[@]};++i));
    do
    
        layer_name=${LAYER_NAMES[i]}
        json_layer_name=${JSON_LAYER_NAMES[i]}

        last_layer_arn=$(aws lambda list-layer-versions --layer-name $layer_name --region $region | jq -r ".LayerVersions | .[0] |  .LayerVersionArn | select (.!=null)")

        if [ -z $last_layer_arn ]; then
             >&2 echo "No layer found for $region, $layer_name"
        else
            echo $last_layer_arn
            INPUT_JSON=$(jq -r ".regions . \"$region\" . \"$json_layer_name\" = \"$last_layer_arn\"" <<< $INPUT_JSON)
        fi
    done
done
echo "Writing to ${FILE_NAME}"
jq '.' <<< $INPUT_JSON > $FILE_NAME
