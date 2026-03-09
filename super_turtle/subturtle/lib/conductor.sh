#!/usr/bin/env bash

if [[ -n "${SUBTURTLE_LIB_CONDUCTOR_SH_LOADED:-}" ]]; then
  return 0
fi
SUBTURTLE_LIB_CONDUCTOR_SH_LOADED=1

# Reserved for conductor/run-state helpers extracted from `ctl`.
