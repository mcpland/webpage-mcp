// import { stderr } from 'process';
// import * as fs from 'fs';
// import * as path from 'path';

// // Set log file path
// const LOG_DIR = path.join(
//   '/Users/hang/code/ai/webpage-mcp-server/app/native-server/dist/',
//   '.debug-log',
// ); // Use different directories to distinguish
// const LOG_FILE = path.join(
//   LOG_DIR,
//   `native-host-${new Date().toISOString().replace(/:/g, '-')}.log`,
// );
// // Make sure the log directory exists
// if (!fs.existsSync(LOG_DIR)) {
//   try {
//     fs.mkdirSync(LOG_DIR, { recursive: true });
//   } catch (err) {
//     stderr.write(`[ERROR] Failed to create log directory: ${err}\n`);
//   }
// }

// // log function
// function writeLog(level: string, message: string): void {
//   const timestamp = new Date().toISOString();
//   const logMessage = `[${timestamp}] [${level}] ${message}\n`;

//   // write to file
//   try {
//     fs.appendFileSync(LOG_FILE, logMessage);
//   } catch (err) {
//     stderr.write(`[ERROR] Failed to write log: ${err}\n`);
//   }

//   // Output to stderr at the same time (does not affect the native messaging protocol)
//   stderr.write(logMessage);
// }

// // log level function
// export const logger = {
//   debug: (message: string) => writeLog('DEBUG', message),
//   info: (message: string) => writeLog('INFO', message),
//   warn: (message: string) => writeLog('WARN', message),
//   error: (message: string) => writeLog('ERROR', message),
// };
