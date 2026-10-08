// Tool name → handler; the matching config (prompt, schema, flags) is configuration/tools/<name>.js
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

export const HANDLERS = {
  claims,
  connect,
  discover,
  disconnect,
  handoff_get,
  handoff_publish,
  inbox,
  memory_save,
  recall,
  recall_get,
  reply,
  review_get,
  review_request,
  review_submit,
  send,
  session_read,
};
