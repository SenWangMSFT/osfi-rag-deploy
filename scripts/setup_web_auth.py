"""Creates or updates the app registration the web app signs users in with (App Service authentication).

Users sign in with Microsoft Entra ID, and the sign-in also gets each user an Azure AI Search token. The web server
forwards that token to the API, so every search runs as the user and returns only their institutions. There's no
client secret: a federated credential lets the web app's managed identity stand in for one.

    python scripts/setup_web_auth.py

Then turn sign-in on by deploying with the client ID it prints (later deployments reuse it):

    $env:WEB_AUTH_CLIENT_ID = '<client id>'; ./scripts/deploy.ps1

A tenant admin grants consent for the delegated permissions: ./scripts/grant_sharepoint_access.ps1
"""

from __future__ import annotations

from _common import GRAPH_SCOPE, AzureClient, load_env

GRAPH = "https://graph.microsoft.com/v1.0"
DISPLAY_NAME = "osfi-rag-poc-web"
GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000"
SEARCH_APP_ID = "880da380-985e-4198-81b9-e05b1cc53158"
GRAPH_SCOPES = ("openid", "profile", "email", "offline_access", "User.Read")
CREDENTIAL_NAME = "web-app-managed-identity"


def main() -> None:
    env = load_env()
    client = AzureClient()

    def graph(method: str, path: str, body: dict | None = None, ok: tuple[int, ...] = (200, 201, 204)):
        return client.request(method, f"{GRAPH}{path}", scope=GRAPH_SCOPE, body=body, ok=ok, wait_for_rbac=False)

    def scope_ids(app_id: str, names: tuple[str, ...]) -> list[dict]:
        sp = graph("GET", f"/servicePrincipals(appId='{app_id}')?$select=oauth2PermissionScopes").json()
        ids = {scope["value"]: scope["id"] for scope in sp["oauth2PermissionScopes"]}
        return [{"id": ids[name], "type": "Scope"} for name in names]

    definition = {
        "displayName": DISPLAY_NAME,
        "signInAudience": "AzureADMyOrg",
        "web": {
            "redirectUris": [f"{env['WEB_APP_URL']}/.auth/login/aad/callback"],
            # App Service authentication signs in with the hybrid flow (response_type "code id_token").
            "implicitGrantSettings": {"enableIdTokenIssuance": True, "enableAccessTokenIssuance": False},
        },
        "requiredResourceAccess": [
            {"resourceAppId": GRAPH_APP_ID, "resourceAccess": scope_ids(GRAPH_APP_ID, GRAPH_SCOPES)},
            {"resourceAppId": SEARCH_APP_ID, "resourceAccess": scope_ids(SEARCH_APP_ID, ("user_impersonation",))},
        ],
    }

    current = env.get("WEB_AUTH_CLIENT_ID")
    query = f"appId eq '{current}'" if current else f"displayName eq '{DISPLAY_NAME}'"
    found = graph("GET", f"/applications?$filter={query}&$select=id,appId").json()["value"]
    if found:
        app = found[0]
        graph("PATCH", f"/applications/{app['id']}", definition)
        print(f"updated  app registration {DISPLAY_NAME} ({app['appId']})")
    else:
        app = graph("POST", "/applications", definition).json()
        print(f"created  app registration {DISPLAY_NAME} ({app['appId']})")
    graph("PATCH", f"/applications/{app['id']}", {"identifierUris": [f"api://{app['appId']}"]})

    if graph("GET", f"/servicePrincipals?$filter=appId eq '{app['appId']}'&$select=id").json()["value"]:
        print("ok       service principal")
    else:
        graph("POST", "/servicePrincipals", {"appId": app["appId"]})
        print("created  service principal")

    credentials = graph("GET", f"/applications/{app['id']}/federatedIdentityCredentials").json()["value"]
    credential = {
        "name": CREDENTIAL_NAME,
        "issuer": f"https://login.microsoftonline.com/{env['AZURE_TENANT_ID']}/v2.0",
        "subject": env["WEB_IDENTITY_PRINCIPAL_ID"],
        "audiences": ["api://AzureADTokenExchange"],
        "description": "The web app's user-assigned identity, used instead of a client secret for sign-in.",
    }
    existing = next((item for item in credentials if item["name"] == CREDENTIAL_NAME), None)
    if existing:
        changes = {key: value for key, value in credential.items() if key != "name"}  # the name can't change
        graph("PATCH", f"/applications/{app['id']}/federatedIdentityCredentials/{existing['id']}", changes)
        print("updated  federated credential for the web app's managed identity")
    else:
        graph("POST", f"/applications/{app['id']}/federatedIdentityCredentials", credential)
        print("created  federated credential for the web app's managed identity")

    print(f"\nWEB_AUTH_CLIENT_ID={app['appId']}")
    if current != app["appId"]:
        print(f"Turn sign-in on: $env:WEB_AUTH_CLIENT_ID = '{app['appId']}'; ./scripts/deploy.ps1")
    print("A tenant admin then grants consent: ./scripts/grant_sharepoint_access.ps1")


if __name__ == "__main__":
    main()
