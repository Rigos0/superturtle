#!/usr/bin/env bash

if [[ -n "${SUBTURTLE_LIB_ENV_SH_LOADED:-}" ]]; then
  return 0
fi
SUBTURTLE_LIB_ENV_SH_LOADED=1

# Reserved for shared environment/bootstrap helpers extracted from `ctl`.
