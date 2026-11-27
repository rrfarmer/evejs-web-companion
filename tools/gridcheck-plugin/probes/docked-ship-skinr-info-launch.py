import blue
from eve.client.script.ui.cosmetics.ship.shipSKINRWindow import ShipSKINRWindow
from eve.client.script.ui.shared.info.infoConst import DATA_BUTTONS
from localization import GetByLabel


def observe():
    info = sm.GetService('info')
    label = GetByLabel('UI/Personalization/ShipSkins/OpenSKINR')
    rows = []
    for type_id in (81348, 82340, 34):
        window = info.ShowInfo(type_id, new=1)
        try:
            for attempt in range(50):
                if hasattr(window.info_content, 'data') and not window.isLoading:
                    break
                blue.pyos.synchro.SleepWallclock(100)
            else:
                raise RuntimeError('Show Info did not load type %s' % type_id)
            actions = window.info_content.data[DATA_BUTTONS]
            matches = [entry for entry in actions if entry[0] == label]
            row = dict(typeID=type_id, actions=[entry[0] for entry in actions], count=len(matches))
            if matches:
                action = matches[0]
                row['command'] = action[1].__name__
                action[1](*action[2])
                opened = ShipSKINRWindow.GetIfOpen()
                row['opened'] = opened is not None
                if opened:
                    opened.Minimize()
                    blue.pyos.synchro.SleepWallclock(300)
                    row['wasMinimized'] = opened.IsMinimized()
                    action[1](*action[2])
                    blue.pyos.synchro.SleepWallclock(300)
                    row['restored'] = ShipSKINRWindow.GetIfOpen() is opened and not opened.IsMinimized()
                action[1](*action[2])
                blue.pyos.synchro.SleepWallclock(300)
                row['closed'] = ShipSKINRWindow.GetIfOpen() is None
            rows.append(row)
        finally:
            window.Close()
    return dict(build=3698585, station=session.stationid, label=label, cases=rows)


result = observe()
