from raffles.client.browse import controller


class Fixture(object):
    has_changes = False
    grabs = 0

    def GetService(self, service):
        if service != 'raffleSvc':
            raise ValueError(service)
        return self

    def get(self):
        return {}, {}

    def grab(self, filters, constraints):
        self.grabs += 1
        return [Offer(value) for value in range(100, 126)]

    def update_raffle(self, raffle):
        return raffle

    def remove_raffle(self, raffle):
        pass


class Offer(object):
    is_expired = False
    is_involved = False

    def __init__(self, price):
        self.ticket_price = price


fixture = Fixture()
browse = controller.BrowsePageController.__new__(controller.BrowsePageController)
browse._storage = fixture
browse.filters = fixture
browse._browsing_raffles = []
browse._browsing_page = 0
had_service = 'sm' in vars(controller)
old_service = vars(controller).get('sm')
try:
    controller.sm = fixture
    visits = []
    for refresh in (False, True, True):
        offers = browse.get_raffles(refresh)
        visits.append(dict(page=browse.page_number + 1, grabs=fixture.grabs,
                           prices=[offer.ticket_price for offer in offers]))
finally:
    if had_service:
        controller.sm = old_service
    else:
        del controller.sm

result = dict(station=session.stationid, pageSize=controller.RAFFLES_PER_PAGE, visits=visits)
