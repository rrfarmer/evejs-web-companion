# Unified Operations Center

Open **Plugins → Unified Operations Center** in Web Companion. You can pin UOC beside PI Manager and Fleet Companion. The launcher opens `/uoc/` in a new tab. Each center has a bookmarkable URL. Closing the tab leaves hosted operations running. See [Page and account access](PAGE.md) for direct links and pilot selection.

| Center | Getting started |
| --- | --- |
| Mining Command Center | Create an operation, assign miners, haulers and defenders, choose where to unload and park, then review readiness. Optional supply preparation tops up a selected library fitting from the personal hangar or Corporation Division 1–7 at the preparation station. Stop and Retry Stop show the last verified freight status. |
| Civilian Missions | Open the Civilian Missions tab in MCC. Save a pilot profile for Delivery or Mining. Start runs the configured mission cycle. Continue finishes one accepted mission and releases the pilot. A pilot with history only can use Set up profile. |
| Distribution Center | Add haulers to the pool and save a Manual Delivery, Collection or Supply operation. Choose the source, destination and items. Manual Delivery and Collection can move all items. Supply maintains a chosen quantity at the destination. |
| Pilot Training | Review a pilot’s required books and skill queue. For onboarding, select a dedicated Director under Corporation HR Pilot and configure the permissions to grant. For books, choose personal funds, corporate coverage of a shortfall, or full corporate prefunding. The last mode verifies the transfer before the trainee purchases the books. |
| Ship Provisioning | Select a pilot and saved fit. Review the available assembled or packaged hull, existing equipment, rigs and supplies before confirming changes. A corporation destination can receive the previous ship. Strategic Cruiser subsystem fitting is unsupported. |
| Combat Operations Center | The hub marks this center **In development**. DED is disabled. MCC Defender routines are available through mining operations. |

Build the shared WC and plugin client with `npm run build:web`. The manifest and lazy page view live in `plugin.ts` and `views.ts`. The Plugin Host runs `backend.ts`, which registers the scoped HTTP routes and Bot Host run types. UOC stores operation documents in the WC installation’s plugin data directory. Existing deployments should keep that directory when upgrading.
