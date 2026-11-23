import {transientNativeRead} from "../shared/progressDeadline.ts";

/** The cycle verified Stop before writing a new native intent, with no earlier pending mutation. */
export class FleetStopBeforeDispatch extends Error {
 constructor(){super("Fleet mining stopped before the next native action.");this.name="FleetStopBeforeDispatch";}
}

/** A native read was temporarily unavailable under the same held owner. */
export class FleetObservationUnavailable extends Error {}

export class FleetShipChanged extends Error {
 readonly capsule:boolean;
 constructor(message:string,capsule=false){super(message);this.capsule=capsule;}
}

/** Classify errors from a known read, never from a native write. */
export function fleetReadFailed(error:unknown):never {
 if(error instanceof FleetObservationUnavailable)throw error;
 const e=error as {code?:unknown;name?:unknown;message?:unknown;cause?:unknown}|null;
 const cause=e?.cause as {code?:unknown;name?:unknown}|null;
 const transport=/^(?:BRIDGE_NETWORK_ERROR|(?:(?:read|write|connect) )?(?:ECONNRESET|ETIMEDOUT))$/;
 if(transientNativeRead(error)||transientNativeRead(cause)||transport.test(String(e?.code??""))||
    transport.test(String(cause?.code??(typeof cause==="string"?cause:e?.message??error??"")))||
    e?.name==="TransportQueueError"||e?.name==="TimeoutError"||cause?.name==="TimeoutError"||
    error instanceof Error&&error.message==="Drone observation timed out.")
  throw new FleetObservationUnavailable(error instanceof Error?error.message:String(error),{cause:error});
 throw error;
}
