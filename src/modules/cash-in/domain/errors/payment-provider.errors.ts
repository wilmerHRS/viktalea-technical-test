/** La pasarela no respondió a tiempo: NO sabemos si cobró (R4.4). */
export class ProviderTimeoutError extends Error {
  constructor(message = 'Payment provider timed out') {
    super(message);
    this.name = 'ProviderTimeoutError';
  }
}

/** No se pudo hablar con la pasarela (error de red o 5xx): tampoco sabemos si cobró (R4.4). */
export class ProviderUnavailableError extends Error {
  constructor(message = 'Payment provider unavailable') {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}
