from raffles.client.details.controller import DetailsPageController
from raffles.client.details.finished_panel import FinishedPanel
from raffles.client.storage import RaffleStorage

service = sm.GetService('raffleSvc')
picked = service.grab({}, {})[0]
class Request(object):
    type_id = picked.type_id
storage = RaffleStorage()
try:
    controller = DetailsPageController(storage)
    same = controller.get_similar_raffles(Request(), 3)
    class MissingType(object):
        type_id = 2147483647
    fallback = controller.get_similar_raffles(MissingType(), 3)
    class Navigation(object):
        def __init__(self):
            self.ids = []
        def open_browse_page(self, id):
            self.ids.append(id)
    class Panel(object):
        _raffle = Request()
        _navigation = Navigation()
    panel = Panel()
    for matching in (True, False):
        panel._view_same_type = matching
        FinishedPanel._handle_view_more.im_func(panel)
    report = dict(station=session.stationid, type=picked.type_id,
                  matched=[row.type_id for row in same], fallback=[row.type_id for row in fallback],
                  viewMore=panel._navigation.ids)
finally:
    storage.close()
result = report
