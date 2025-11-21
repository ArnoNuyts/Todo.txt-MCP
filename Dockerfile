FROM denoland/deno:distroless

EXPOSE 3000

WORKDIR /app

# Prefer not to run as root.
#USER deno

# Cache the dependencies as a layer (the following two steps are re-run only when deps.ts or deno.json changes).
# Ideally cache deps.ts if you have one, or deno.json
# COPY deno.json .
# COPY deps.ts . 
# RUN deno cache deps.ts

# These steps will be re-run upon each file change in your working directory:
COPY . .
# Compile the main app so that it doesn't need to be compiled each startup/entry.
# RUN deno cache server.ts

ENV PORT=3000

CMD ["run", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "server.ts"]
