from carbonui.util.bunch import Bunch
from carbon.common.script.sys import service
from eveservices.xmppchat import GetChatService
from xmppchatclient import xmppchatsvc, xmppchatwindow, xmppchannelsettings
import uthread2


class AdminOnlySession(object):
    role = service.ROLE_CHTADMINISTRATOR

    def __getattr__(self, name):
        return getattr(session, name)


def observe():
    chat = GetChatService()
    room = chat.GetChannelByDisplayName('German Help')[0][0]
    joined = chat.IsJoined(room)
    try:
        if not joined:
            chat.JoinChannel(room, suppressMessage=True)
        for _ in range(40):
            window = chat.GetGroupChatWindow(room)
            if window:
                break
            uthread2.sleep(0.25)
        if chat.IsOwnerOfChannel(room) or chat.IsOperatorOfChannel(room):
            raise RuntimeError('Expected a room without observer affiliation')
        namespaces = [module.__dict__ for module in (xmppchatsvc, xmppchatwindow, xmppchannelsettings)]
        prior = [('session' in namespace, namespace.get('session')) for namespace in namespaces]
        projected = AdminOnlySession()
        dialog = None
        try:
            for namespace in namespaces:
                namespace['session'] = projected
            entries = []
            window.MaybeAddSettingsOptionsToMenuParent(Bunch(AddIconEntry=lambda **kw: entries.append(kw)))
            entries[0]['callback']()
            dialog = xmppchannelsettings.ChannelSettingsDlg.GetIfOpen(windowID='ChannelSettingsDlg_%s' % room)
            return dict(station=session.stationid, room=room, label=entries[0]['text'], operatorOnly=dialog.operatorOnly,
                        owner=chat.IsOwnerOfChannel(room), operator=chat.IsOperatorOfChannel(room),
                        name=dialog.channelName.GetValue())
        finally:
            if dialog and not dialog.destroyed:
                dialog.Close()
            for namespace, (present, value) in zip(namespaces, prior):
                if present:
                    namespace['session'] = value
                else:
                    del namespace['session']
    finally:
        if not joined:
            chat.LeaveChannel(room)


result = observe()
