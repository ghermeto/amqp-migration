## Migrate between 2 AMQP brokers

This script was created to drain a queue in one broker and move all the messages to another broker.

### Requirements

- [Node.js 16+](https://nodejs.org/en/)
- 

### Setup

- Clone [the repository](https://github.com/ghermeto/amqp-migration)
- Run: `npm install`

### Usage

```shell
$ <environment vars> npm start
```

#### Environment variables

| Name                     | Required | Type     | Description |
| ------------------------ | -------- | -------- | ----------- |
| AMQP_SOURCE_URL          | *YES*    | URL      | URL for the broker you want to drain  | 
| AMQP_SOURCE_CHANNEL      |          | number   | Channel ID for a specific channel you want to use for the source broker  |
| AMQP_SOURCE_QUEUE        | *YES*    | string   | Name of the source queue to be drained  |
| AMQP_DESTINATION_URL     | *YES*    | URL      | URL for the destination broker (the one you want to get the messages)  |
| AMQP_DESTINATION_QUEUE   |          | string   | Name of the destination queue to be populated. If not provided, script will use the incoming message exchange and routing rule |
| REDIS_URL                |          | URL      | URL to a cache redis instance  |
| ENABLE_FILE_LOGGER       |          | string   | Creates one file per message to accomodate extremely large messages. String 'yes' will enabled it.  |
| RETRY_ON_FAIL            |          | string   | Prevents the script from crashing on a catastrophic event. Retries every 2 seconds. String 'yes' will enabled it.  |
| FILE_LOGS_PATH           |          | path     | Path to save the log files, if file logging is enabled. String 'yes' will enabled it.  |
| PRINT_RETURNED_BODY      |          | string   | Print the message body in the console. Default no. String 'yes' will enabled it.  |
| LOG_LEVEL                |          | string   | Console log level. 'info', 'warn', 'error' levels available. Default 'info'  |

