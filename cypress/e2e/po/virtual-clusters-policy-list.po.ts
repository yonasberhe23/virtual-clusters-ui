import PagePo from '@rancher/cypress/e2e/po/pages/page.po';

/**
 * The Virtual Cluster Policy list (K3K.POLICY in pkg/virtual-clusters/types.js).
 *
 * The landing page redirects here once the controller is installed, so reaching this
 * page is how the suite asserts the extension has moved on from the install state.
 */
export default class VirtualClustersPolicyListPagePo extends PagePo {
  private static createPath(clusterId: string) {
    return `/c/${ clusterId }/virtualclusters/k3k.io.virtualclusterpolicy`;
  }

  static goTo(clusterId: string): Cypress.Chainable<Cypress.AUTWindow> {
    return super.goTo(VirtualClustersPolicyListPagePo.createPath(clusterId));
  }

  constructor(clusterId: string) {
    super(VirtualClustersPolicyListPagePo.createPath(clusterId));
  }
}
