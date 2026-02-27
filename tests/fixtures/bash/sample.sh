#!/usr/bin/env bash

source ./utils.sh
. ./config.sh

greet() {
    local name="$1"
    echo "Hello, ${name}!"
}

add() {
    local a="$1"
    local b="$2"
    echo $((a + b))
}

clamp() {
    local value="$1"
    local min="$2"
    local max="$3"
    if [[ "$value" -lt "$min" ]]; then
        echo "$min"
    elif [[ "$value" -gt "$max" ]]; then
        echo "$max"
    else
        echo "$value"
    fi
}

main() {
    greet "World"
    add 2 3
}

main "$@"
