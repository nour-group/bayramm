import { createMediaHandler } from "./handler";

const handle = createMediaHandler();

export default {
  fetch: (request, env) => handle(request, env),
} satisfies ExportedHandler<Env>;
