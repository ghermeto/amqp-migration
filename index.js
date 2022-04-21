import {run, startGracefulShutdown} from './runner.js'

// adding graceful shutdown for Ctrl+C
process.on('SIGINT', startGracefulShutdown);
process.on('SIGTERM', startGracefulShutdown);

// run and exit on error
run().catch(err => process.exit(0));
