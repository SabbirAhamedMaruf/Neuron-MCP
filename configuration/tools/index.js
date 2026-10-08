// Every tool Neurons exposes, in the order clients list them; each has a handler of the same name in src/tools/
import claims from './claims.js';
import connect from './connect.js';
import discover from './discover.js';
import disconnect from './disconnect.js';
import handoff_get from './handoff_get.js';
import handoff_publish from './handoff_publish.js';
import inbox from './inbox.js';
import memory_save from './memory_save.js';
import recall from './recall.js';
import recall_get from './recall_get.js';
import reply from './reply.js';
import review_get from './review_get.js';
import review_request from './review_request.js';
import review_submit from './review_submit.js';
import send from './send.js';
import session_read from './session_read.js';

export const TOOLS = [
  discover,
  connect,
  disconnect,
  inbox,
  send,
  reply,
  recall,
  recall_get,
  memory_save,
  session_read,
  handoff_publish,
  handoff_get,
  review_request,
  review_get,
  review_submit,
  claims,
];
