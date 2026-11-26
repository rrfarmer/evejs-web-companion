from raffles.client.storage import RaffleStorage
from signals import Signal

class KnownRaffle(object):
    def __init__(self):
        self.sold = 0
        self.winner = None

    def update_sold_ticket_count(self, count):
        self.sold = count

    def update_winning_ticket(self, ticket):
        self.winner = ticket

class Reporter(object):
    def __init__(self):
        self.delivered = []
        self.finished = []

    def update(self, data):
        self.delivered.append(data)

    def finish(self, row):
        self.finished.append(row.winner)

storage = RaffleStorage.__new__(RaffleStorage)
known = KnownRaffle()
storage._raffles = {7: known}
reporter = Reporter()
storage.update_raffle = reporter.update
storage.on_raffle_finished = Signal()
storage.on_raffle_finished.connect(reporter.finish)
storage.OnRaffleUpdatedServer(7, 'known update')
storage.OnRaffleUpdatedServer(8, 'uncached update')
storage.OnTicketsUpdatedServer({7: 8, 8: 5})
storage.OnRaffleFinishedServer(7, 'winning ticket')
storage.OnRaffleCreatedServer(8, 'created')
result = dict(station=session.stationid, methods=list(RaffleStorage.__notifyevents__),
              received=reporter.delivered, sold=known.sold, finished=reporter.finished)
