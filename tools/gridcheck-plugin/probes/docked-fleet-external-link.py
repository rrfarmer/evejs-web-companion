import blue
from eve.client.script.ui.shared.fleet.fleetwindow import FleetWindow
from eve.common.script.util import esiUtils
from localization import GetByLabel


def observe():
    fleet = sm.GetService('fleet')
    if session.fleetid:
        raise RuntimeError('A fresh docked pilot is required')
    clipboard = []
    original_copy = esiUtils.CopyTextToClipboard
    original_base = esiUtils.GetESIBaseUrl
    original_tenant = esiUtils.GetESITenant
    try:
        label = GetByLabel('UI/Fleet/FleetWindow/GetFleetID')
        window = FleetWindow.Open()
        fleetless = any(item and item.GetText() == label for item in window.GetFleetMenuTop())
        fleet.CreateFleet()
        for _ in range(40):
            if session.fleetid and session.charid in fleet.members:
                break
            blue.pyos.synchro.SleepWallclock(200)
        window = FleetWindow.Open()
        fleet_id = session.fleetid
        if fleet_id is None or not any(item and item.GetText() == label for item in window.GetFleetMenuTop()):
            raise RuntimeError('Boss fleet and external-link action required')
        esiUtils.CopyTextToClipboard = clipboard.append
        window._CopyESIFleetUrlToClipboard()
        esiUtils.GetESIBaseUrl = lambda _: 'https://esi.example.invalid'
        esiUtils.GetESITenant = lambda _: 'codex-fixture'
        window._CopyESIFleetUrlToClipboard()
        return dict(build=3698585, station=session.stationid, label=label, fleetless=fleetless,
                    id=fleet_id, clipboard=clipboard)
    finally:
        esiUtils.CopyTextToClipboard = original_copy
        esiUtils.GetESIBaseUrl = original_base
        esiUtils.GetESITenant = original_tenant
        FleetWindow.CloseIfOpen()
        if session.fleetid:
            fleet.LeaveFleet()


result = observe()
