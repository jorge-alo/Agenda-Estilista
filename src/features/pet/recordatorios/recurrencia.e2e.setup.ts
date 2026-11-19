/** TEST PRELOADER ONLY. Not imported by production, no clock override or environment-file reads. */
import http from "node:http";
import https from "node:https";
import { Socket,Server } from "node:net";
import cron from "node-cron";
import dotenv from "dotenv";

if (process.env.NODE_ENV === "production") throw new Error("LOCAL_TEST_GUARD_REFUSES_PRODUCTION");
let remoteAttempts=0, realSchedules=0;
const ownedPorts=new Map<number,number>();
const serverPorts=new WeakMap<Server,number>();
const originalListen=Server.prototype.listen;
Server.prototype.listen=function(this:Server,...args:unknown[]):Server {
  const register=()=>{
    const address=this.address();
    if(address && typeof address!=="string" && !serverPorts.has(this)){
      serverPorts.set(this,address.port);ownedPorts.set(address.port,(ownedPorts.get(address.port)??0)+1);
    }
  };
  this.once("listening",register);
  this.once("close",()=>{
    const port=serverPorts.get(this);if(port===undefined)return;
    const remaining=(ownedPorts.get(port)??1)-1;
    if(remaining)ownedPorts.set(port,remaining);else ownedPorts.delete(port);
    serverPorts.delete(this);
  });
  const result=Reflect.apply(originalListen,this,args) as Server;register();return result;
} as Server["listen"];
function blocked():never {remoteAttempts++;throw new Error("LOCAL_TEST_EXTERNAL_NETWORK_BLOCKED");}
function local(host:string) {
  return ["localhost","127.0.0.1","::1","0.0.0.0"].includes(host.replace(/^\[|\]$/g,""));
}
function object(value:unknown):value is Record<string,unknown> {return typeof value==="object" && value!==null;}
function requestHost(input:unknown):string|null {
  if(typeof input==="string" || input instanceof URL){
    try{return new URL(input).hostname;}catch{return null;}
  }
  if(object(input)){
    const host=input.hostname??input.host??"localhost";
    if(typeof host!=="string")return null;
    return host==="::1"?host:host.replace(/:\d+$/,"").replace(/^\[|\]$/g,"");
  }
  return null;
}
for(const module of [http,https])for(const name of ["request","get"] as const){
  const original=module[name];
  Object.defineProperty(module,name,{configurable:true,writable:true,value:function(this:unknown,...args:unknown[]){
    const host=requestHost(args[0]);if(host!==null && !local(host))blocked();
    return Reflect.apply(original,this,args);
  }});
}
const originalConnect=Socket.prototype.connect;
Socket.prototype.connect=function(this:Socket,...args:unknown[]):Socket {
  const first=Array.isArray(args[0])?args[0][0]:args[0];
  // IPC paths remain usable by the test runner; all remote TCP is denied before DNS/connect.
  if(typeof first==="string" && !/^\d+$/.test(first))return Reflect.apply(originalConnect,this,args) as Socket;
  if(object(first) && typeof first.path==="string")return Reflect.apply(originalConnect,this,args) as Socket;
  const host=object(first)?first.host??first.hostname??"localhost":typeof args[1]==="string"?args[1]:"localhost";
  const port=object(first)?first.port:first;
  // MySQL is pinned by pagos.test.setup. Other TCP must belong to a server created by this test process.
  if(typeof host!=="string" || !local(host) || Number(port)!==3307 && !ownedPorts.has(Number(port)))blocked();
  return Reflect.apply(originalConnect,this,args) as Socket;
} as Socket["connect"];

const originalFetch=globalThis.fetch;
globalThis.fetch=((input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
  const target=object(input) && "url" in input?input.url:input;
  const host=requestHost(target);if(host!==null && !local(host))blocked();
  return originalFetch(input,init);
}) as typeof fetch;

const noEnvironmentFile=()=>({parsed:{}});
for(const name of ["config","configDotenv"])Object.defineProperty(dotenv,name,{configurable:true,writable:true,value:noEnvironmentFile});
for(const name of ["schedule","createTask"])Object.defineProperty(cron,name,{configurable:true,writable:true,value:()=>{
  realSchedules++;throw new Error("LOCAL_TEST_REAL_SCHEDULER_BLOCKED");
}});

process.on("exit",()=>{
  if(remoteAttempts || realSchedules){
    console.error("Local test containment violation",{remoteAttempts,realSchedules});
    process.exitCode=1;
  }
});
