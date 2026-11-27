import blue
import evetypes
from eve.client.script.ui.shared.fleet.fleetbroadcast import BroadcastHistoryPanel
from eve.client.script.ui.shared.fleet.fleetwindow import FleetWindow
from utillib import KeyVal


def labels(menu):
    out = []
    for row in menu:
        if row is None:
            continue
        if hasattr(row, 'GetText'):
            out.append(row.GetText())
            continue
        caption, action = row[:2]
        if hasattr(caption, 'GetText'):
            caption = caption.GetText()
        if isinstance(caption, tuple):
            from localization import GetByLabel
            caption = GetByLabel(caption[0], **caption[1])
        out.append([caption, labels(action)] if isinstance(action, list) else caption)
    return out


def entry(**data):
    return KeyVal(sr=KeyVal(node=KeyVal(data=KeyVal(**data))))


def observe():
    fleet = sm.GetService('fleet')
    if session.fleetid:
        raise RuntimeError('A fresh docked pilot is required')
    try:
        fleet.CreateFleet()
        for _ in range(40):
            if session.fleetid and session.charid in fleet.members:
                break
            blue.pyos.synchro.SleepWallclock(200)
        FleetWindow.Open()
        events = {}
        for name in ('HoldPosition', 'NeedBackup', 'TravelTo', 'Location', 'JumpBeacon', 'WarpTo', 'AlignTo', 'JumpTo',
                     'Target', 'HealArmor', 'HealShield', 'HealCapacitor', 'HealTarget'):
            target = 60003760 if name == 'TravelTo' else 30000142
            events[name] = labels(BroadcastHistoryPanel.GetBroadcastMenu(None, entry(
                name=name, charID=session.charid, solarSystemID=30000142, itemID=target,
                typeID=5 if name == 'JumpBeacon' else None)))
        from eve.client.script.parklife import fleetSvc
        prompt = fleetSvc.prompt_player_fsd_dialog
        distance = []
        try:
            fleetSvc.prompt_player_fsd_dialog = lambda name, args: distance.append([name, args])
            fleet.DistanceToFleetMate(30000142, None)
        finally:
            fleetSvc.prompt_player_fsd_dialog = prompt
        favorites = fleet.GetFavorite(session.charid)
        try:
            fleet.AddFavorite([session.charid])
            self_watch = bool(fleet.GetFavorite(session.charid))
        finally:
            if not favorites and fleet.GetFavorite(session.charid):
                fleet.RemoveFavorite(session.charid)
        industry_types = []
        blueprint_svc = sm.GetService('blueprintSvc')
        for type_id in (785, 784, 30187):
            menu = BroadcastHistoryPanel.GetLootMenu(None, entry(charID=session.charid, typeID=type_id))
            copy = blueprint_svc.GetBlueprintTypeCopy(type_id)
            industry_types.append(dict(typeID=type_id, name=evetypes.GetName(type_id), category=evetypes.GetCategoryID(type_id),
                                       original=copy.original, menu=labels(menu)))
        return dict(build=3698585, station=session.stationid, broadcasts=events,
                    distance=distance, selfWatch=self_watch,
                    member=labels(BroadcastHistoryPanel.GetMemberMenu(None, entry(charID=session.charid))),
                    left=labels(BroadcastHistoryPanel.GetMemberMenu(None, entry(charID=140000002))),
                    loot=labels(BroadcastHistoryPanel.GetLootMenu(None, entry(charID=session.charid, typeID=1230))),
                    industryTypes=industry_types)
    finally:
        FleetWindow.CloseIfOpen()
        if session.fleetid:
            fleet.LeaveFleet()


result = observe()
