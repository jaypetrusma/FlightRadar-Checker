<#  THIS SCRIPT IS DESIGNED TO GET THE DESTINATION OF FLIGHTS THAT FLY OVER MY HOUSE BC I HAVE AN INATE DESIRE TO KNOW  #>

$APIToken = Get-Secret -Name FR24Token -AsPlainText
$queryBounds = Get-Secret -Name BoundingBox -AsPlainText #I'm not doxxing myself
$webhookURL = Get-Secret -Name WebhookURL -AsPlainText #no spamming my webhooks

$FRHeaders = @{
    "Accept" = "application/json";
    "Accept-Version" = "v1";
    "Authorization" = "Bearer $APIToken"
}

$iataList = Import-Csv -Path .\iata.csv

#$FlightInfo = Invoke-WebRequest -Method Get -Uri "https://fr24api.flightradar24.com/api/live/flight-positions/full?bounds=$queryBounds" -Headers $FRHeaders
$FlightInfoData = $FlightInfo.Content | ConvertFrom-Json
$flight = $FlightInfoData.data.flight

$airport = $iataList | Where-Object { $_.iata -eq $FlightInfoData.data.dest_iata }
$airport = $airport.airport

if ($flight) { 
    $message = "That flight is $flight, going to $airport!" 
    
    $webhookHeaders = @{
        "Content-Type" = "application/json";
    }

    $body = @{ content = $message }
    $requestBody = $body | ConvertTo-Json

    Invoke-WebRequest -Method Post -Uri $webhookURL -Headers $webhookHeaders -Body $requestBody
    
}

$APIToken = ""
$queryBounds = ""
$webhookURL = ""