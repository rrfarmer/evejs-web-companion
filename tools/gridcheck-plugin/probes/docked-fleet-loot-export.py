import blue
from collections import OrderedDict
from eve.client.script.ui.shared.fleet import fleetUtil
from eve.client.script.ui.shared.fleet.fleetwindow import FleetWindow
from localization import GetByLabel
from utillib import KeyVal


def observe():
    fleet = sm.GetService('fleet')
    if session.fleetid:
        raise RuntimeError('A fresh docked pilot is required')
    native_blue = fleetUtil.blue
    native_dialog = fleetUtil.prompt_player_fsd_dialog
    files = []
    dialogs = []

    class ResFile(object):
        def __init__(self, kind):
            if kind != 'blue.ResFile':
                raise RuntimeError(kind)
            self.chunks = []
            self.path = None

        def Open(self, path, mode):
            return False

        def Create(self, path):
            self.path = path

        def Write(self, chunk):
            self.chunks.append(chunk)

        def Close(self):
            files.append(dict(path=self.path, text=''.join(self.chunks).decode('utf-8')))

    try:
        fleet.CreateFleet()
        for _ in range(40):
            if session.fleetid and session.charid in fleet.members:
                break
            blue.pyos.synchro.SleepWallclock(200)
        window = FleetWindow.Open()
        label = GetByLabel('UI/Fleet/FleetWindow/ExportLootHistory')
        command = next(item for item in window.GetFleetMenuTop() if item and item.GetText() == label)
        fleetUtil.blue = KeyVal(os=native_blue.os, classes=KeyVal(CreateInstance=ResFile),
                               sysinfo=KeyVal(GetUserDocumentsDirectory=lambda: 'Documents'))
        fleetUtil.prompt_player_fsd_dialog = lambda name, values: dialogs.append([name, values])
        command.ExecuteFunction()
        fleet.OnFleetLootEvent(OrderedDict([((140000001, 34), 3), ((140000002, 35), 2)]))
        fleet.OnFleetLootEvent(OrderedDict([((140000001, 34), 5)]))
        command.ExecuteFunction()
        rows = [[row.charID, row.typeID, row.quantity, row.solarSystemID] for row in fleet.GetLootHistory()]
        return dict(build=3698585, station=session.stationid, label=label, rows=rows, files=files, dialogs=dialogs)
    finally:
        fleetUtil.blue = native_blue
        fleetUtil.prompt_player_fsd_dialog = native_dialog
        FleetWindow.CloseIfOpen()
        if session.fleetid:
            fleet.LeaveFleet()


result = observe()
