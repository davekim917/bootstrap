#!/bin/bash

# SessionStart hook: Display current date and time
CURRENT_DATE=$(date '+%Y-%m-%d')
CURRENT_TIME=$(date '+%H:%M:%S %Z')

echo "Session started: $CURRENT_DATE at $CURRENT_TIME"

exit 0
