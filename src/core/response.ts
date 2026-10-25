export class HttpError extends Error {status:number;code:string;detail:string;constructor(status:number,code:string,detail:string){super(detail);this.status=status;this.code=code;this.detail=detail;}}
export function assert(condition:unknown,status:number,code:string,detail:string):asserts condition{if(!condition)throw new HttpError(status,code,detail);}
export function jsonSafeParse<T=Record<string,unknown>>(raw:string|null|undefined,fallback:T):T {try{return raw?JSON.parse(raw):fallback;}catch{return fallback;}}
export function jsonResponse(data:unknown,status=200):Response {return Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});}
