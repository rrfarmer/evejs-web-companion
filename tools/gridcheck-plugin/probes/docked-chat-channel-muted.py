import uthread2
from carbonui import const as uiconst
from eveservices.xmppchat import GetChatService
from localization import GetByLabel
from xmppchatclient import xmppchatsvc
from xmppchatclient.xmppchannelsettings import ChannelSettingsDlg


def observe():
    chat = GetChatService()
    name = 'Gridcheck channel muted 13534'
    if chat.GetChannelByDisplayName(name):
        return {'fixtureNameInUse': True}
    targets = [140000001, 140000002]
    room = chat.CreateChannel(name)
    original = xmppchatsvc.prompt_player_fsd_dialog
    window = None
    try:
        chat.JoinChannel(room, suppressMessage=True)
        for _ in range(20):
            if chat.IsJoined(room):
                break
            uthread2.sleep(0.2)
        window = ChannelSettingsDlg.Open(channel=room, windowID='ChannelSettingsDlg_%s' % room)
        window.OnMutedTab()
        before = chat.GetUsersWithTemporaryRestriction(room, 'mute')
        for target in targets:
            chat.MuteUser(room, target, u'Gridcheck fixture', 120)
        window.PopulateMutedList()
        muted = chat.GetUsersWithTemporaryRestriction(room, 'mute')
        window._RemoveMuted(targets)
        return dict(station=session.stationid, before=before, muted=muted,
                    after=chat.GetUsersWithTemporaryRestriction(room, 'mute'),
                    labels=[GetByLabel(path) for path in ('UI/Chat/Muted', 'UI/Chat/RemoveSelected')],
                    hint=GetByLabel('UI/Chat/HowtoMuteHint'))
    finally:
        if window and not window.destroyed:
            window.Close()
        try:
            xmppchatsvc.prompt_player_fsd_dialog = lambda *args: uiconst.ID_YES
            chat.DeleteChannel(room)
        finally:
            xmppchatsvc.prompt_player_fsd_dialog = original


result = observe()
