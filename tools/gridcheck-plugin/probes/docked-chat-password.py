import uthread2
from carbonui import const as uiconst
from carbonui.util.bunch import Bunch
from chatutil import GetErrorCode
from eveservices.xmppchat import GetChatService
from localization import GetByLabel
from xmppchatclient import xmppchatsvc
from xmppchatclient.xmppchannelsettings import ChannelSettingsDlg
from xmppchatclient.xmppchatpassword import ChannelPasswordWindow


def observe():
    chat = GetChatService()
    name = 'Gridcheck password channel 13543'
    secret = u'stage-room-13543'
    if not session.stationid or chat.GetChannelByDisplayName(name):
        raise RuntimeError('Expected a docked observer and an unused fixture name')
    room = chat.CreateChannel(name)
    original_prompt = xmppchatsvc.prompt_player_fsd_dialog
    original_helper = chat._GetPasswordHelper
    original_join = chat._JoinChannelHelper
    original_pref = settings.user.ui.Get('%sPassword' % room)
    prompts = []
    answers = [None, u'incorrect-fixture-answer', secret]

    def answer(channel, display, retry):
        dialog = ChannelPasswordWindow.Open(channel=channel, title=GetByLabel('UI/Chat/PasswordRequired', channelName=display),
                                            retry=retry, windowID='gridcheck-chat-password-13543')
        prompts.append(dict(title=dialog.title, retry=bool(retry), checked=bool(dialog.rememberPwdCb.GetValue())))
        dialog.OnCancel()
        return answers.pop(0)

    try:
        if not chat.XmppChatMgr.GrantChannelOwnership(room):
            raise RuntimeError('The observer cannot recover temporary room ownership')
        chat.JoinChannel(room, suppressMessage=True)
        for _ in range(20):
            if chat.IsJoined(room):
                break
            uthread2.sleep(0.2)
        config = ChannelSettingsDlg.Open(channel=room, windowID='ChannelSettingsDlg_%s' % room)
        config.password.SetValue(secret)
        config.retyped.SetValue(secret)
        config.OnOK()
        chat.SetAffiliation(room, 140000001, 'owner')
        chat.SetAffiliation(room, session.charid, 'member')
        if chat.IsOwnerOfChannel(room):
            raise RuntimeError('The fixture failed to remove observer ownership')
        chat.LeaveChannel(room)
        # The installed-client reference runs on its older Gridcheck-enabled
        # image. Drive its retry UI with the same presence error shape, then
        # delegate the accepted password to its live transport.
        error = Bunch(attributes={'code': '401'})
        refusal = Bunch(attributes={'type': 'error'},
                        find_child_with_tag=lambda tag: error if tag == 'error' else None)
        chat._JoinChannelHelper = lambda channel, password, history: (
            original_join(channel, password, history) if channel != room or password == secret else refusal)
        code = GetErrorCode(refusal)
        chat._GetPasswordHelper = answer
        cancelled = not chat.JoinChannel(room, suppressMessage=True) and not chat.IsJoined(room)
        accepted = bool(chat.JoinChannel(room, suppressMessage=True))
        return dict(station=session.stationid, room=room, refusal=code, prompts=prompts,
                    cancelled=cancelled, accepted=accepted,
                    labels=[GetByLabel(path) for path in ('UI/Menusvc/PasswordRequired',
                            'UI/Menusvc/PleaseEnterPassword', 'UI/Menusvc/PleaseTryEnteringPasswordAgain',
                            'UI/Chat/SavePassword', 'UI/Chat/ChannelWindow/JoinChannel')])
    finally:
        chat._GetPasswordHelper = original_helper
        chat._JoinChannelHelper = original_join
        try:
            if not chat.IsOwnerOfChannel(room):
                chat.XmppChatMgr.GrantChannelOwnership(room)
            xmppchatsvc.prompt_player_fsd_dialog = lambda *args: uiconst.ID_YES
            chat.DeleteChannel(room)
        finally:
            xmppchatsvc.prompt_player_fsd_dialog = original_prompt
            settings.user.ui.Set('%sPassword' % room, original_pref)


result = observe()
