'use strict';

function asBoolean(value, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  if (typeof value === 'number') return value !== 0;
  return defaultValue;
}

module.exports = {
  ENABLE_CONTEXT_ACTIVATION: asBoolean(process.env.ENABLE_CONTEXT_ACTIVATION, true),
  ENABLE_NEW_OMI_ROUTES: asBoolean(process.env.ENABLE_NEW_OMI_ROUTES, true),
  ENABLE_PROMPT_WORKERS: asBoolean(process.env.ENABLE_PROMPT_WORKERS, false),
  QUIET_HOURS_ENABLED: asBoolean(process.env.QUIET_HOURS_ENABLED, true)
};

