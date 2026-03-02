#!/usr/bin/env node
import path from 'path';
import { COMMAND_NAME } from './constant';
import { colorText, registerWithElevatedPermissions, writeNodePathFile } from './utils';

/**
 * main function
 */
async function main(): Promise<void> {
  console.log(colorText(`Registering ${COMMAND_NAME} Native MessagingHost...`, 'blue'));

  try {
    // Write Node.js path before registration
    writeNodePathFile(path.join(__dirname, '..'));

    await registerWithElevatedPermissions();
    console.log(
      colorText('Registration successful! Chrome extensions can now communicate with local services via Native Messaging. ', 'green'),
    );
  } catch (error: any) {
    console.error(colorText(`Registration failed: ${error.message}`, 'red'));
    process.exit(1);
  }
}

// Execute main function
main();
