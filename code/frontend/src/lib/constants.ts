// Shared source for application metadata and tunable defaults.
// Update backend/src/bedrock_editor/app_constants.json instead of duplicating values.
import config from "../../../backend/src/bedrock_editor/app_constants.json";

export const APP_BRAND = config.brand;
export const APP_EDITION = config.edition;
export const APP_NAME = `${APP_BRAND} ${APP_EDITION}`;
export const APP_CAPTION = config.caption;
export const APP_DESCRIPTION = config.description;
export const APP_VERSION = config.version;
export const APP_VERSION_LABEL = `${config.channel} ${APP_VERSION}`;
export const APP_TITLE = `${APP_NAME} · ${APP_CAPTION}`;
export const APP_CLOSE_PROMPT = `确定关闭 ${APP_NAME}？`;
export const RENDER_DISTANCE = Object.freeze(config.render_distance);
export const FLIGHT_SPEED = Object.freeze(config.flight_speed);
export const MAP_QUALITY = Object.freeze(config.map_quality);
