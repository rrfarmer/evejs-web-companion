from localization import GetByLabel
from raffles.client.character_stats import CharacterStats

class Record(object):
    def __init__(self, owner, ticket):
        self.is_finished = False
        self.is_raffle_owner = owner
        self.is_ticket_owner = ticket

stats = CharacterStats()
stats.update_active([Record(True, False), Record(False, True), Record(True, True)])
reply = sm.GetService('raffleSvc').get_character_statistics()
keys = ('raffles_participated', 'raffles_won', 'finished_delivered',
        'finished_undelivered', 'finished_expired', 'created_running')
result = dict(station=session.stationid, totals={key: reply[key] for key in keys},
              active=[stats.created_active, stats.joined_active],
              labels=[GetByLabel('UI/HyperNet/' + key, amount=7) for key in
                      ('Created', 'Completed', 'Active', 'Joined', 'Won')])
