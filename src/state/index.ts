import fs from "fs";
import path from "path";
import { config } from "../config/index.js";
import type { AppState, StrategyId } from "../types/index.js";
import { logger } from "../utils/logger.js";

const STATE_FILE = path.join(config.dataDir, "state.json");

const DEFAULT_STATE: AppState = {
  lastOptimization: null,
  lastUpdated: null,
  earningsHistory: [],
  highApyProducts: [],
  volatilePositions: [],
  activeStrategy: "conservative",
};

export function loadState(): AppState {
  try {
    if (!fs.existsSync(STATE_FILE)) return { ...DEFAULT_STATE };
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    return JSON.parse(raw) as AppState;
  } catch (err) {
    logger.error("[State] Failed to load state, using default", err);
    return { ...DEFAULT_STATE };
  }
}

export function saveState(state: AppState): void {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    logger.error("[State] Failed to save state", err);
  }
}
