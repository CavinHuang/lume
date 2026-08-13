export const BrowserErrorCodes = {
    NOT_CONNECTED: "E_NOT_CONNECTED",
    NOT_IMPLEMENTED: "E_NOT_IMPLEMENTED",
    UNSUPPORTED: "E_UNSUPPORTED",
    PERMISSION_DENIED: "E_PERMISSION_DENIED",
    CONFIRMATION_REQUIRED: "E_CONFIRMATION_REQUIRED",
    TAB_NOT_FOUND: "E_TAB_NOT_FOUND",
    TAB_NOT_CLAIMED: "E_TAB_NOT_CLAIMED",
    TAB_OWNED_BY_OTHER_SESSION: "E_TAB_OWNED_BY_OTHER_SESSION",
    DEBUGGER_ATTACH_FAILED: "E_DEBUGGER_ATTACH_FAILED",
    CDP_COMMAND_DENIED: "E_CDP_COMMAND_DENIED",
    PAGE_SCRIPT_FAILED: "E_PAGE_SCRIPT_FAILED",
    TIMEOUT: "E_TIMEOUT",
    PAYLOAD_TOO_LARGE: "E_PAYLOAD_TOO_LARGE",
    NATIVE_HOST_VERSION_MISMATCH: "E_NATIVE_HOST_VERSION_MISMATCH"
};
export class BrowserRuntimeException extends Error {
    code;
    details;
    recoverable;
    constructor(code, message, details, recoverable = true) {
        super(message);
        this.code = code;
        this.details = details;
        this.recoverable = recoverable;
    }
}
