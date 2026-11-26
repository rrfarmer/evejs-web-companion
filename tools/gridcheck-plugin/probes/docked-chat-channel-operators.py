import uthread2
from carbonui import const as uiconst
from eveservices.xmppchat import GetChatService
from localization import GetByLabel
from xmppchatclient import xmppchatsvc
from xmppchatclient.xmppchannelsettings import ChannelSettingsDlg


def observe():
    chat = GetChatService()
    name = 'Gridcheck channel operators 13535'
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
        window.OnOperatorsTab()
        before = chat.GetUsersWithAffiliation(room, 'admin')
        chat.SetAffiliation(room, target, 'admin')
        window.PopulateOperatorsList()
        added = chat.GetUsersWithAffiliation(room, 'admin')
        window._RemoveOp([target])
        return dict(station=session.stationid, actor=session.charid, target=target,
                    before=before, added=added, after=chat.GetUsersWithAffiliation(room, 'admin'),
                    members=chat.GetUsersWithAffiliation(room, 'member'), operatorOnly=window.operatorOnly,
                    labels=[GetByLabel(path) for path in ('UI/Chat/Operators', 'UI/Chat/AddToOperatorList', 'UI/Chat/RemoveSelected')])
    finally:
        if window and not window.destroyed:
            window.Close()
        try:
            xmppchatsvc.prompt_player_fsd_dialog = lambda *args: uiconst.ID_YES
            chat.DeleteChannel(room)
        finally:
            xmppchatsvc.prompt_player_fsd_dialog = original


result = observe()
