import uthread2
from carbonui import const as uiconst
from carbonui.util.bunch import Bunch
from eveservices.xmppchat import GetChatService
from localization import GetByLabel
from xmppchatclient import xmppchatsvc
from xmppchatclient.xmppchannelsettings import ChannelSettingsDlg


def observe():
    chat = GetChatService()
    title = 'Gridcheck tab settings 13868'
    if chat.GetChannelByDisplayName(title):
        raise RuntimeError('The temporary channel already exists')
    player = chat.CreateChannel(title)
    system = chat.GetChannelByDisplayName('English Help')[0][0]
    system_was_joined = chat.IsJoined(system)
    original = xmppchatsvc.prompt_player_fsd_dialog
    out = {}
    try:
        for room in (player, system):
            if not chat.IsJoined(room):
                chat.JoinChannel(room, suppressMessage=True)
        for _ in range(40):
            if all(room in chat.groupChatWindows for room in (player, system)):
                break
            uthread2.sleep(0.25)
        local = next(window.receiver for window in chat.groupChatWindows.values()
                     if getattr(window, 'receiver', '').startswith('local_'))
        for room in (player, system, local):
            window = chat.groupChatWindows[chat.GetWindowNameForGroup(room)]
            entries = []
            gear_menu = Bunch(AddIconEntry=lambda **kw: entries.append(kw))
            window.MaybeAddSettingsOptionsToMenuParent(gear_menu)
            labels = [getattr(entry, 'text', None) for entry in window.GetMenu().GetEntries()]
            row = dict(room=room, context=GetByLabel('UI/Chat/Configuration') in labels,
                       gear=[entry['text'] for entry in entries], opened=False)
            if entries:
                entries[0]['callback']()
                settings = ChannelSettingsDlg.GetIfOpen(windowID='ChannelSettingsDlg_%s' % room)
                if settings:
                    row.update(opened=True, name=settings.channelName.GetValue(), operatorOnly=settings.operatorOnly)
                    settings.Close()
            out[room.split('_')[0]] = row
        return dict(station=session.stationid, rooms=out, contextLabel=GetByLabel('UI/Chat/Configuration'))
    finally:
        if not system_was_joined:
            chat.LeaveChannel(system)
        try:
            xmppchatsvc.prompt_player_fsd_dialog = lambda *args: uiconst.ID_YES
            chat.DeleteChannel(player)
        finally:
            xmppchatsvc.prompt_player_fsd_dialog = original


result = observe()
