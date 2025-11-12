<#  THIS SCRIPT IS DESIGNED TO GET THE DESTINATION OF FLIGHTS THAT FLY OVER MY HOUSE BC I HAVE AN INATE DESIRE TO KNOW  #>

$APIToken = Get-Secret -Name FR24Token -AsPlainText
$queryBounds = Get-Secret -Name BoundingBox -AsPlainText #I'm not doxxing myself
$headers = @{
    "Accept" = "application/json";
    "Accept-Version" = "v1";
    "Authorization" = "Bearer $APIToken"
}

$iataList = Import-Csv -Path .\iata.csv

#$FlightInfo = Invoke-WebRequest -Method Get -Uri "https://fr24api.flightradar24.com/api/live/flight-positions/full?bounds=$queryBounds" -Headers $headers
$FlightInfoData = $FlightInfo.Content | ConvertFrom-Json
echo $FlightInfoData.data.flight
echo $FlightInfoData.data.dest_iata

$result = $iataList | Where-Object { $_.iata -eq $FlightInfoData.data.dest_iata }

if ($result) {
    Write-Host "Match found:"
    $result | Select-Object -Property airport
} else {
    Write-Host "No match found."
}