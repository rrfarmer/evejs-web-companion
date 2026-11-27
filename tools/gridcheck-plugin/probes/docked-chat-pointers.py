import blue
from eveservices.xmppchat import GetChatService
from eve.client.script.ui.shared.pointerTool import pointerToolConst as names, pointerToolUtil
from eve.client.script.ui.shared.pointerTool.pointerChains import FindChainForPointer
from eve.client.script.ui.shared.pointerTool.pointerToolFunctions import GetScreenElementsByUniqueName
from localization import GetByLabel
from xmppchatclient.xmppchatchannels import XmppChatChannels


def observe():
    pointer_ids = (names.UNIQUE_NAME_LOCAL_CHAT, names.UNIQUE_NAME_CORP_CHAT,
                   names.UNIQUE_NAME_CORP_CHAT_SETTINGS, names.UNIQUE_NAME_CORP_CHAT_RELOAD_MOTD,
                   names.UNIQUE_NAME_FLEET_CHAT, names.UNIQUE_NAME_FLEET_CHAT_SETTINGS,
                   names.UNIQUE_NAME_FLEET_CHAT_RELOAD_MOTD, names.UNIQUE_NAME_CHANNEL_WND,
                   names.UNIQUE_NAME_CREATE_CHANNEL_BTN)
    groups = pointerToolUtil.GetFilteredScrollList('', None, names.SOURCE_LOCATION_WINDOW)
    group = next(row for row in groups if row.label == GetByLabel('UI/Help/PointerWndUiElements'))
    catalogue = [dict(name=row.uiElementName, label=row.label, texture=row.texturePath,
                      chain=FindChainForPointer(row.uiElementName)) for row in group.GetSubContent(group) if row.uiElementName in pointer_ids]

    def sample():
        pointer = sm.GetService('helpPointer')
        windows = [pointer.FindLocalChatWindow(names.UNIQUE_NAME_LOCAL_CHAT),
                   pointer.FindCorpChatWindow(names.UNIQUE_NAME_CORP_CHAT),
                   pointer.FindFleetChatWindow(names.UNIQUE_NAME_FLEET_CHAT)]
        anchors = GetScreenElementsByUniqueName(pointer_ids)
        return dict(rooms=[type(window).__name__ if window else None for window in windows],
                    visible=sorted(name for name, element in anchors.iteritems() if element and not element.destroyed and element.display))

    fleet = sm.GetService('fleet')
    directory = XmppChatChannels.GetIfOpen()
    if session.fleetid or directory:
        raise RuntimeError('A fresh docked pilot is required')
    before = sample()
    try:
        directory = XmppChatChannels.Open()
        blue.pyos.synchro.SleepWallclock(400)
        directory_open = sample()
        fleet.CreateFleet()
        for attempt in range(35):
            if session.fleetid and GetChatService().GetGroupChatWindow('fleet_%s' % session.fleetid):
                break
            blue.pyos.synchro.SleepWallclock(200)
        return dict(build=3698585, station=session.stationid, catalogue=catalogue,
                    before=before, directory=directory_open, fleet=sample())
    finally:
        if directory and not directory.destroyed:
            directory.Close()
        if session.fleetid:
            fleet.LeaveFleet()


result = observe()
