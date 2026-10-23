# Moving the post office to a public host

The post office is one HTTPS server with one data dir (`store.db`, `cert.pem`,
`key.pem`, `config.json`). Laptops pin its **certificate fingerprint**, not its
hostname, so any host works as long as raw TCP reaches the office: the office
does its own TLS. Never put it behind a host's HTTPS domain or TLS-terminating
proxy; the laptops would see the host's certificate and refuse it.

The image is host-agnostic (`post-office/Dockerfile`, built from the repo root):

```
docker build -f post-office/Dockerfile -t collab-post-office .
```

It never runs `init`. A fresh office restarts the note counter and would hand
out numbers the team already used, so the container exits with a message until
the old office's data is in `/data`.

Settings (all optional):

| what | how | default |
|---|---|---|
| data dir | `--data`, else env `COLLAB_OFFICE_DATA` | `/data` in the image |
| listen port | `--port`, else env `PORT`, else `config.json` | 7443 from `init` |
| one-time data | env `COLLAB_OFFICE_BOOTSTRAP` (see the move) | none |

The port the office listens on is the one in its log line `post office
listening on port N`. Point the host's TCP forwarding at that port.

## The move (do it in this order)

0. **Prepare the host first** (service, `/data` volume, TCP forwarding; see below)
   so you know the public host:port before anything stops. Until step 3 the
   container exits with "no post office in /data": that is expected.
1. **Stop the local office** (Ctrl+C on `collab-post-office serve`). From here on
   nobody can sync until step 6.
2. **Bundle it**, with the new public address:
   ```
   collab-post-office bundle office.tgz --url https://<public host>:<public port>
   ```
   This writes `office.tgz` (store.db copied with `VACUUM INTO`, plus cert, key
   and config) and `office.tgz.b64` (the same, as text for an env var). `--url`
   changes the address in the snapshot only. It refuses while the office's port is
   still in use. Run `collab-post-office set-url <url> --data <dir>` on an
   unpacked snapshot instead if you want to change it after bundling,
   then run `bundle` again on that dir (`--data <dir>`): the env var and the
   upload must carry the edited copy.
3. **Put the data on the host**: either unpack `office.tgz` into the host's `/data`
   volume (`tar -xzf office.tgz -C /data`), or, on a host with no shell or file
   upload, set `COLLAB_OFFICE_BOOTSTRAP` to the contents of `office.tgz.b64`.
   On first start the container unpacks it only if `/data/store.db` is missing.
   The bundle prints a warning above about 100 KB: most hosts cap one env var
   near 128 KB, and a store with real notes is usually bigger. Then use a file
   upload or a shell instead.
4. **Start the container** and check the log for `listening on port` and the same
   `certificate fingerprint` as before.
5. **Remove `COLLAB_OFFICE_BOOTSTRAP`** and delete `office.tgz` and
   `office.tgz.b64` everywhere: they hold the office's private key. While the
   variable is still set, the container logs a reminder on every start.
6. **On every laptop**: `collab sync set-address https://<public host>:<public port>`.
   Join codes printed before the move still carry the old address: revoke those
   unused members on the new office, then `add-member` again.
7. **Never start the old local office again.** Its counter would hand out numbers
   the new office also hands out. Delete its data dir once the new one works.

Membership commands (`add-member`, `revoke`, `status`, `set-office-role`, ...)
now run **where store.db lives**, not on the old laptop copy:

```
docker exec <container> node /app/post-office/dist/bin.js add-member "<name>"
```

(`COLLAB_OFFICE_DATA=/data` is set in the image, so no `--data` is needed.)

## Railway

- New service from this repo. Set the variable `RAILWAY_DOCKERFILE_PATH=post-office/Dockerfile`.
- Add a **volume** mounted at `/data`.
- Set `PORT=7443` so the office's port is fixed and known.
- Networking: add a **TCP Proxy** to port 7443. Do **not** generate an HTTP domain;
  Railway's domain terminates TLS and laptops would refuse it. The TCP proxy gives
  an address like `xyz.proxy.rlwy.net:12345`: the office URL is
  `https://xyz.proxy.rlwy.net:12345`. Use it in step 2's `--url`.
- Data: `railway ssh` into the service and unpack into `/data`, or use
  `COLLAB_OFFICE_BOOTSTRAP` when the bundle is small enough.
- Membership commands: `railway ssh`, then `node /app/post-office/dist/bin.js ...`.

## A Linux VM or company server

With Docker:

```
docker run -d --name collab-post-office --restart unless-stopped \
  -p 7443:7443 -v /srv/collab-office:/data collab-post-office
```

Copy `office.tgz` to the server and `tar -xzf office.tgz -C /srv/collab-office`
before the first start. Open TCP 7443 in the firewall (and the cloud provider's
security list, e.g. Oracle's). The office URL is `https://<server address>:7443`.
Build the image on the same CPU type as the server (x64 or arm64): it fetches
the cr-sqlite add-on for the CPU it is built on. From an x64 machine for an
arm64 server: `docker buildx build --platform linux/arm64 -f post-office/Dockerfile -t collab-post-office .`

Without Docker (Node 20.9 or newer, plus `unzip`: the cr-sqlite fetch uses it):

```
git clone <repo> /opt/collab && cd /opt/collab
npm ci -w @collab-mcp/core -w @collab-mcp/post-office
npm -w @collab-mcp/core run build && npm -w @collab-mcp/post-office run build
npm run fetch:crsqlite
```

If `npm ci` stops with `EBADPLATFORM` on `@rolldown/binding-win32-x64-msvc` (a
Windows-only package of the ui), add `--force`; the office does not use it.

Unpack the bundle into a data dir (e.g. `/var/lib/collab-office`), then a systemd unit:

```
[Unit]
Description=collab post office
After=network-online.target

[Service]
WorkingDirectory=/opt/collab
Environment=COLLAB_OFFICE_DATA=/var/lib/collab-office
ExecStart=/usr/bin/node post-office/dist/bin.js serve
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`systemctl enable --now collab-office`, then follow steps 4 to 7.
