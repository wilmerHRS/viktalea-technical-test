/** Operaciones que se reservan en cada ciclo; con el lease cubre lote × timeout (design §6.4). */
export const RECONCILE_BATCH_SIZE = 10;

/** Motivo con el que falla una operación que la pasarela nunca llegó a recibir. */
export const CHARGE_NOT_FOUND_REASON = 'Charge not found at payment provider';
