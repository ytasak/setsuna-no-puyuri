// reaction-lab のエントリポイント。
// 実体は adapters/node-ws.js、判定ロジックは core/match.js。
import { startServer } from './adapters/node-ws.js';
startServer();
