# Deploy Keys (SSH) in NanoClaw

NanoClaw runs agents in **ephemeral containers** (fresh VM per message). That means anything you create inside the container (including `~/.ssh/*`) is destroyed at the end of a run **unless it’s mounted from the host**.

## Persistent SSH directory (main)

For the **main** chat, NanoClaw mounts this host directory into the container at `/home/node/.ssh`:

- `data/ssh/main/`

Put deploy keys and SSH config files there.

Recommended contents:
- `data/ssh/main/config`
- `data/ssh/main/known_hosts`
- `data/ssh/main/id_<name>` (private deploy key, e.g. `id_framekeep`)
- `data/ssh/main/id_<name>.pub` (optional)

## Example SSH config (GitHub + Framekeep)

`data/ssh/main/config`:

```
Host github.com github.com-framekeep
  HostName github.com
  User git
  IdentityFile /home/node/.ssh/id_framekeep
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  UserKnownHostsFile /home/node/.ssh/known_hosts
```

## Notes

- Use **deploy keys** per repo where possible instead of a broad personal SSH key.
- Keep permissions tight (`0600` for private keys). NanoClaw will try to harden permissions on startup.
- If a repo’s `origin` is **HTTPS**, `git push/pull` may block waiting for credentials inside the container. Prefer `git@github.com:...` SSH remotes for anything the agent should access.
