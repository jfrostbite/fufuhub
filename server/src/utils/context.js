/**
 * Shared runtime context (WebSocket clients, Scheduler instance)
 * Decouples index.js from routes and services to eliminate circular imports.
 */

let taskScheduler = null;
let wsClients = new Set();

export function setTaskScheduler(scheduler) {
  taskScheduler = scheduler;
}

export function getTaskScheduler() {
  return taskScheduler;
}

export function setWsClients(clients) {
  wsClients = clients;
}

export function broadcastToClients(data) {
  wsClients.forEach((client) => {
    if (client.readyState === 1) { // WebSocket.OPEN = 1
      client.send(JSON.stringify(data));
    }
  });
}
