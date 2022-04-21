export default class BaseLogger {
    #enabled;
    #logger;

    constructor({ logger = console, enabled }) {
        this.#logger = logger;
        this.#enabled = enabled;
    }

    get isEnabled() {
        return this.#enabled;
    }

    get logger() {
        return this.#logger;
    }

    disable() {
        this.#enabled = false;
    }

    /**
     * @async
     * @param {string} id 
     * @param {any} message 
     */
     async push(id, message) {
        this.#logger.warn('Base logger is a no-op');
    }

    /**
     * @async
     * @param {string} id 
     * @returns {any}
     */
     async get(id) {
        this.#logger.warn('Base logger is a no-op');
        return;
    }
}