import blue
from carbonui import const as uiconst
from chat.client import chat_service
from eveservices.xmppchat import GetChatService
from localization import GetByLabel
from xmppchatclient.xmppchannelmenu import XmppChannelMenu


def observe():
    services = sm
    chat = services.GetService('chat')
    window = GetChatService().groupChatWindows['local']
    room = window.receiver
    target = 140000001
    records = []
    prompts = []
    original_prompt = chat_service.prompt_player_fsd_dialog
    original_messages = window.messages
    original_reported = set(chat._reported_spammer_ids)
    original_sm = getattr(chat_service, 'sm', None)
    had_sm = 'sm' in chat_service.__dict__

    class CapturedRemote(object):
        def GetService(self, service):
            return services.GetService(service)

        def RemoteSvc(self, service):
            if service != 'userSvc':
                raise RuntimeError(service)
            return self

        def ReportISKSpammer(self, *args):
            records.append(args)

    def prompt(key, data, buttons):
        prompts.append(dict(key=key, name=data['name'], yesNo=buttons == uiconst.YESNO))
        return uiconst.ID_NO if len(prompts) == 1 else uiconst.ID_YES

    try:
        window.messages = [(target, 'Gridcheck line %s' % i, blue.os.GetWallclockTime(), None) for i in range(12)]
        window.messages.append((session.charid, 'Reporter line', blue.os.GetWallclockTime(), None))
        chat._reported_spammer_ids.discard(target)
        chat_service.sm = CapturedRemote()
        chat_service.prompt_player_fsd_dialog = prompt
        actions = XmppChannelMenu(room, target)
        report = next(invoke for _, invoke in actions if callable(invoke) and invoke.__name__ == 'ReportISKSpammer')
        for _ in range(3):
            report()
        return dict(station=session.stationid, room=room, label=GetByLabel('UI/Chat/ReportIskSpammer'),
                    selfHasReport=any(callable(invoke) and invoke.__name__ == 'ReportISKSpammer'
                                      for _, invoke in XmppChannelMenu(room, session.charid)),
                    prompts=prompts, calls=records)
    finally:
        if had_sm:
            chat_service.sm = original_sm
        else:
            del chat_service.sm
        chat_service.prompt_player_fsd_dialog = original_prompt
        window.messages = original_messages
        chat._reported_spammer_ids.clear()
        chat._reported_spammer_ids.update(original_reported)


result = observe()
