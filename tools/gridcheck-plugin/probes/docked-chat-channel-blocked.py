import uthread2
from carbonui import const as uiconst
from eveservices.xmppchat import GetChatService
from localization import GetByLabel
from xmppchatclient import xmppchatsvc
from xmppchatclient.xmppchannelsettings import ChannelSettingsDlg


def observe():
    chat = GetChatService()
    name = 'Gridcheck channel blocked 13533'
    if chat.GetChannelByDisplayName(name):
        return {'fixtureNameInUse': True}
    target = 140000001
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
        window.OnBlockedTab()
        chat.SetAffiliation(room, target, 'outcast')
        permanent = chat.GetUsersWithAffiliation(room, 'outcast')
        window._RemoveBlocked([target])
        after_permanent = chat.GetUsersWithAffiliation(room, 'outcast')
        chat.BanUserFromChannel(room, target, 'Gridcheck fixture', 120)
        temporary = chat.GetUsersWithTemporaryRestriction(room, 'ban')
        window._RemoveBlocked([target])
        return dict(station=session.stationid, labels=[GetByLabel(path) for path in (
                    'UI/Chat/Blocked', 'UI/Chat/AddToBlockedList', 'UI/Chat/TemporaryBan')],
                    permanent=permanent, afterPermanent=after_permanent,
                    temporary=temporary, afterTemporary=chat.GetUsersWithTemporaryRestriction(room, 'ban'))
    finally:
        if window and not window.destroyed:
            window.Close()
        try:
            xmppchatsvc.prompt_player_fsd_dialog = lambda *args: uiconst.ID_YES
            chat.DeleteChannel(room)
        finally:
            xmppchatsvc.prompt_player_fsd_dialog = original


result = observe()
