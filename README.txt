CampusSpace AI — Live Reservation Prototype

Start the service
1. Install Node.js 18 or newer on the computer that will host the prototype.
2. Double-click Start_CampusSpace_Live_Prototype.bat.
3. Open http://127.0.0.1:4174 in a browser.
4. The server window prints a one-time admin setup code on first run. Keep this window open.
5. In the prototype, choose Admin view · sign in. Paste the setup code, set the admin email and a 12+ character passphrase, then create access.

Reservation workflow
- Students search rooms, choose Request this room, and submit a name, group, and contact email.
- Requests are stored by the server and begin Pending.
- The admin approves or declines requests. Approval rechecks room capacity, accessibility, equipment, recurring classes, dated events, and other approved reservations.
- Approved reservations appear as live conflicts for other browsers connected to this same server. The page refreshes the reservation feed every 15 seconds.
- Admins can export the reservation queue to CSV.
- Reservations persist in data/store.json. Back up or remove that file only when you intend to preserve or clear the local demo records.

What “live” means here
This build has a real local HTTP service and shared persistent reservation store. Anyone opening the same server address can see availability changes and submit requests. By default it listens only on this computer (127.0.0.1); it is not publicly reachable, and it does not write to the university’s official booking system. Public multi-user access requires a hosted deployment with HTTPS, protected secrets, database backups, and institutional review. Official reservations require an API or integration details from the campus booking system.

Room ranking model
- Algorithm: Ridge Regression trained from scratch by `train-model.mjs`; the resulting coefficients are saved in `room-ranker.json` and loaded by the live prototype.
- The training script creates candidate room/request examples from the supplied synthetic room, schedule and request records. It hard-filters capacity, required equipment and schedule/event clashes before ranking.
- The target is a transparent synthetic allocation rubric (excess capacity, scheduled class hours and purpose/type fit), because the supplied requests contain no assigned room IDs or observed student room choices.
- Training uses a deterministic 80/20 split by request row. The printed holdout scores measure reproduction of that synthetic rubric, not real-world room-choice accuracy.
- Refit after changing the source data with `npm run train:model`, then restart the server.

Data and security limits
- All supplied campus datasets are synthetic. This model is genuinely fitted from scratch, but its labels are rubric-generated; it does not validate real user preferences or institutional booking outcomes.
- This prototype stores requester names and emails in data/store.json without encryption at rest. Use synthetic contact details only; do not enter real student information.
- The admin password is stored as a scrypt hash and the session uses an HttpOnly cookie, but the prototype is still not production-ready. Use institutional identity, HTTPS, a managed database, access controls, audit logs, and a security review before real deployment.
- The room schedule and event records are the supplied synthetic data; they do not reflect current campus occupancy.
