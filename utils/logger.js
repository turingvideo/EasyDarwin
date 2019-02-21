var winston = require('winston');
const { combine, timestamp, label, printf } = winston.format;

var isProd = process.env.NODE_ENV === 'production';

const loggerFormat = printf(({ level, message, label, timestamp }) => {
        return `${timestamp} [${label}] ${level}: ${message}`;
});

const logger = winston.createLogger({
    level: isProd ? 'info': 'debug',
    format: combine(
        label({ label: 'DEFAULT' }),
        timestamp(),
        loggerFormat
    ),
    transports: [
        new (winston.transports.Console)({ json: false, timestamp: true }),
        // new winston.transports.File({ filename: __dirname + '/debug.log', json: false })
    ],
    exceptionHandlers: [
        new (winston.transports.Console)({ json: false, timestamp: true }),
        // new winston.transports.File({ filename: __dirname + '/exceptions.log', json: false })
    ],
    exitOnError: false
});

module.exports = logger;
