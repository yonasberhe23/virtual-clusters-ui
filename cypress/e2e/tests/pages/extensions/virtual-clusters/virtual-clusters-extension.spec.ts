import ClusterDashboardPagePo from '@rancher/cypress/e2e/po/pages/explorer/cluster-dashboard.po';
import ProductNavPo from '@rancher/cypress/e2e/po/side-bars/product-side-nav.po';
import { EXTRA_LONG_TIMEOUT_OPT } from '@rancher/cypress/support/utils/timeouts';

import ExtensionsPagePo from '../../../../po/extensions-page.po';
import VirtualClustersLandingPagePo, { NAV_LABEL } from '../../../../po/virtual-clusters-landing.po';
import VirtualClustersPolicyListPagePo from '../../../../po/virtual-clusters-policy-list.po';
import {
  loginAsAdmin, rancherVersion, clusterIdByName, waitForClusterActive, waitForClusterConnected, deleteResource, createAwsHostCluster,
  k3kIsInstalled, waitForK3kInstalled, uninstallK3k, k3kChartRepo, K3K_CHART_NAME, K3K_REPO_NAME, K3K_NAMESPACE
} from '../../../../utils/rancher-api';

const EXTENSION_NAME = 'Virtual Clusters';
// Which build of the extension to test:
//   'released'  - install the newest published version from the chart repo (default)
//   'dev-load'  - CI builds it from this checkout and developer-loads it before Cypress
//                 starts, so there is no chart repo to add and nothing to install or
//                 uninstall here. The only way to reach selectors that are on main but
//                 not yet in a published chart.
//   <version>   - install that exact published version, e.g. '1.2.1' or '1.2.1-rc1'
const EXTENSION_VERSION = `${ Cypress.env('extensionVersion') || 'released' }`;
const DEV_LOADED = EXTENSION_VERSION === 'dev-load';
// The install modal defaults to the newest published version, which is what an
// undefined version leaves it on.
const PINNED_VERSION = ['dev-load', 'released'].includes(EXTENSION_VERSION) ? undefined : EXTENSION_VERSION;
const HELM_REPO_URL = 'https://rancher.github.io/virtual-clusters-ui';
const HELM_REPO_NAME = 'virtual-clusters-ui';

// UIPlugin created by a catalog install is named after the chart
const UI_PLUGIN_ID = 'cattle-ui-plugin-system/virtual-clusters';

// The controller is published to SUSE's registry as an OCI chart, and the install sets
// both images to the same registry. A public default would still install, so the test
// pins all three rather than only asserting success.
const K3K_REPO_URL = 'oci://registry.suse.com/rancher/charts/appco-suse-virtual-cluster-engine';
const SUSE_REGISTRY = 'registry.suse.com';

const CLUSTER_NAMESPACE = 'fleet-default';
// EC2 placement for the host cluster, matching what rancher/dashboard's own
// provisioning specs use. Only the credentials come from the environment.
const AWS_REGION = 'us-west-1';
const AWS_ZONE = 'a';
const AWS_VPC_ID = 'vpc-081cec85dbe35e9bd';
const AWS_INSTANCE_TYPE = 't3a.medium';
// waitForClusterActive polls every 1.5s; an EC2 RKE2 cluster takes 10-15 min to
// become active, so allow ~20 min.
const CLUSTER_ACTIVE_RETRIES = 800;
// The agent connects shortly after the cluster goes active - ~5 min at 1.5s per poll.
const CLUSTER_CONNECTED_RETRIES = 200;

// The extension is Prime-only (catalog.cattle.io/prime-only) and every product it
// registers is hidden behind isRancherPrime(), so fail fast with a clear message
// rather than timing out on a missing card later.
function assertRancherPrime() {
  rancherVersion().then((version) => {
    expect(
      version.RancherPrime?.toLowerCase(),
      `${ EXTENSION_NAME } is Prime-only, but /rancherversion reports RancherPrime=${ version.RancherPrime }`
    ).to.eq('true');
  });
}

describe('Virtual Clusters extension', { testIsolation: false, tags: ['@adminUser', '@jenkins'] }, () => {
  let hostClusterName = '';
  let hostClusterId = '';
  let removeHostCluster = false;
  let removeRepo = false;
  let removeExtension = false;
  let removeK3k = false;

  /** Provision the downstream host cluster the virtual clusters will live in. */
  function provisionHostCluster() {
    cy.createE2EResourceName('vc-host').then((name: string) => {
      hostClusterName = name;
      removeHostCluster = true;

      createAwsHostCluster({
        name,
        namespace:    CLUSTER_NAMESPACE,
        region:       AWS_REGION,
        accessKey:    Cypress.env('awsAccessKey'),
        secretKey:    Cypress.env('awsSecretKey'),
        instanceType: AWS_INSTANCE_TYPE,
        vpcId:        AWS_VPC_ID,
        zone:         AWS_ZONE,
      });

      waitForClusterActive(CLUSTER_NAMESPACE, name, CLUSTER_ACTIVE_RETRIES).then((active) => {
        expect(active, `host cluster '${ name }' did not become active`).to.eq(true);
      });

      clusterIdByName(name).then((id) => {
        hostClusterId = id;

        // Being active is not enough to browse to /c/<id>/explorer: the dashboard
        // redirects to /dashboard/home until the cluster's agent is connected.
        waitForClusterConnected(id, CLUSTER_CONNECTED_RETRIES).then((connected) => {
          expect(connected, `host cluster '${ name }' agent never connected`).to.eq(true);
        });
      });
    });
  }

  /**
   * Add the published chart repository and install the extension from it. The teardown
   * flags are raised before each step rather than after, so a failure part way through
   * still cleans up - deleteResource tolerates anything that was never created.
   */
  function installPublishedExtension() {
    const extensionsPo = new ExtensionsPagePo();

    cy.then(() => {
      removeRepo = true;
    });
    extensionsPo.addHelmRepository(HELM_REPO_URL, HELM_REPO_NAME);

    extensionsPo.goTo();
    extensionsPo.waitForPage();
    cy.then(() => {
      removeExtension = true;
    });
    extensionsPo.installExtensionFromCatalog(EXTENSION_NAME, HELM_REPO_NAME, 'vcInstall', PINNED_VERSION);
  }

  /** A host cluster that already has k3k never renders the install button. */
  function assertK3kAbsent() {
    cy.then(() => {
      k3kIsInstalled(hostClusterId).then((installed) => {
        expect(installed, `host cluster '${ hostClusterName }' already has something in ${ K3K_NAMESPACE }`).to.eq(false);
      });
    });
  }

  before(() => {
    loginAsAdmin();
    assertRancherPrime();

    provisionHostCluster();

    if (!DEV_LOADED) {
      installPublishedExtension();
    }

    assertK3kAbsent();
  });

  it('shows the Virtual Clusters navigation entry and landing page on the downstream cluster', () => {
    VirtualClustersLandingPagePo.navTo(hostClusterId);

    const landingPage = new VirtualClustersLandingPagePo(hostClusterId);

    landingPage.waitForPage();
    landingPage.title().should('be.visible');
  });

  it('installs the k3k controller from the SUSE registry chart and moves on to the policy list', () => {
    cy.intercept('POST', '**/catalog.cattle.io.ClusterRepo/*?action=install').as('installK3k');

    VirtualClustersLandingPagePo.navTo(hostClusterId);

    const landingPage = new VirtualClustersLandingPagePo(hostClusterId);

    landingPage.waitForPage();

    // From here on the controller may exist, so teardown has to remove it even if an
    // assertion below fails.
    cy.then(() => {
      removeK3k = true;
    });
    landingPage.installK3kButton().click();

    cy.wait('@installK3k', EXTRA_LONG_TIMEOUT_OPT).then(({ request, response }) => {
      expect(response?.statusCode, 'install request rejected').to.eq(201);

      const chart = request.body?.charts?.[0];

      expect(request.body?.namespace, 'install targets the k3k namespace').to.eq(K3K_NAMESPACE);
      expect(chart?.chartName, 'install targets the SUSE chart').to.eq(K3K_CHART_NAME);
      expect(chart?.values?.controller?.image?.registry, 'controller image registry').to.eq(SUSE_REGISTRY);
      expect(chart?.values?.agent?.shared?.image?.registry, 'kubelet image registry').to.eq(SUSE_REGISTRY);
    });

    landingPage.installSucceeded().should('be.visible');

    k3kChartRepo(hostClusterId).then((resp) => {
      expect(resp.status, `ClusterRepo '${ K3K_REPO_NAME }' was not created`).to.eq(200);
      expect(resp.body?.spec?.url, 'chart repository url').to.eq(K3K_REPO_URL);
    });

    // Installing swaps the button for a confirmation rather than navigating, so
    // revisiting is what exercises the redirect to the policy list.
    waitForK3kInstalled(hostClusterId).then((installed) => {
      expect(installed, `k3k did not appear in ${ K3K_NAMESPACE }`).to.eq(true);
    });

    VirtualClustersLandingPagePo.navTo(hostClusterId);
    new VirtualClustersPolicyListPagePo(hostClusterId).waitForPage();
  });

  it('stops offering the install button once k3k-system is occupied', () => {
    k3kIsInstalled(hostClusterId).then((installed) => {
      expect(installed, `nothing occupies ${ K3K_NAMESPACE }, so there is no detection to assert`).to.eq(true);
    });

    VirtualClustersLandingPagePo.navTo(hostClusterId);

    new VirtualClustersPolicyListPagePo(hostClusterId).waitForPage();
    new VirtualClustersLandingPagePo(hostClusterId).installK3kButton().self().should('not.exist');

    // Loading the landing page directly must redirect too, not just the nav route.
    VirtualClustersLandingPagePo.goTo(hostClusterId);
    new VirtualClustersPolicyListPagePo(hostClusterId).waitForPage();
  });

  // Nothing to uninstall when the extension was developer-loaded rather than installed.
  (DEV_LOADED ? it.skip : it)('uninstalls the extension and removes the navigation entry', () => {
    const extensionsPo = new ExtensionsPagePo();

    extensionsPo.goTo();
    extensionsPo.waitForPage();
    extensionsPo.extensionTabInstalledClick();
    extensionsPo.waitForPage(undefined, 'installed');

    extensionsPo.extensionCardUninstallClick(EXTENSION_NAME);
    extensionsPo.extensionUninstallModal().should('be.visible');
    extensionsPo.uninstallModalUninstallClick();
    extensionsPo.extensionReloadBanner().should('be.visible');
    extensionsPo.extensionReloadClick();
    cy.then(() => {
      removeExtension = false;
    });

    ClusterDashboardPagePo.goTo(hostClusterId);
    new ClusterDashboardPagePo(hostClusterId).waitForPage();

    new ProductNavPo().navToSideMenuGroupByLabelExistence(NAV_LABEL, 'not.exist');
  });

  after('clean up', () => {
    // Removing the controller first keeps a rerun against a reused host cluster in the
    // uninstalled state the install test requires.
    if (removeK3k) {
      uninstallK3k(hostClusterId);
    }
    if (removeExtension) {
      deleteResource('v1', 'catalog.cattle.io.uiplugins', UI_PLUGIN_ID);
    }
    if (removeRepo) {
      deleteResource('v1', 'catalog.cattle.io.clusterrepos', HELM_REPO_NAME);
    }
    if (removeHostCluster) {
      deleteResource('v1', `provisioning.cattle.io.clusters/${ CLUSTER_NAMESPACE }`, hostClusterName);
    }
  });
});
