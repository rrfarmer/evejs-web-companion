from sovereignty.mercenaryden.client.notice_listener import ExternalNoticeListener

class NoticeRegistry(object):
    def __init__(self):
        self.types = []

    def subscribe_to_notice(self, message_type, callback):
        self.types.append(dict(type=message_type.DESCRIPTOR.full_name,
                               fields=[field.name for field in message_type.DESCRIPTOR.fields]))

registry = NoticeRegistry()
listener = ExternalNoticeListener(registry)
result = dict(station=session.stationid, notices=registry.types)
