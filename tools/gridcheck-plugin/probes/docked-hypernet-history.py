from localization import GetByLabel
from raffles.client.history.controller import HistoryPageController

class Filters(object):
    sorting = (None, False)

class Record(object):
    def __init__(self, name, finished, interaction, end_time):
        self.item_name = name
        self.is_finished = finished
        self.requires_interaction = interaction
        self.end_time = end_time

controller = HistoryPageController.__new__(HistoryPageController)
controller.filters = Filters()
controller._my_raffles = [Record('Closed earlier', True, False, 1),
                          Record('Z active', False, False, 0),
                          Record('Closed later', True, False, 2),
                          Record('Claimable', True, True, 0),
                          Record('A active', False, False, 0)]
controller._sort_raffles()
history = sm.GetService('raffleSvc').get_history()
result = dict(station=session.stationid, count=len(history),
              order=[row.item_name for row in controller._sorted_raffles],
              labels=[GetByLabel(label) for label in ('UI/HyperNet/TabNameBrowse', 'UI/HyperNet/TabNameMyRaffles',
                                                       'UI/HyperNet/PageTitleHistory', 'UI/Common/NoDataAvailable')])
